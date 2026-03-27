import React from "react";
import { Box, Text } from "ink";

interface ConfigModeProps {
  strategy: string;
  permissionMode: string;
  outputStyle: string;
  sandbox: string;
  role?: string;
}

export function ConfigMode({
  strategy,
  permissionMode,
  outputStyle,
  sandbox,
  role,
}: ConfigModeProps) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box flexDirection="row" flexGrow={1}>
        {/* Left: Config tree */}
        <Box
          borderStyle="round"
          borderColor="gray"
          flexDirection="column"
          paddingX={1}
          width="50%"
        >
          <Text bold color="magenta">
            {" "}
            Configuration
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              {" "}
              <Text color="green" bold>
                ●
              </Text>{" "}
              <Text bold>General</Text>
            </Text>
            <Text color="gray">
              {" "}
              Strategy: <Text color="white">{strategy}</Text>
            </Text>
            <Text color="gray">
              {" "}
              Permission: <Text color="white">{permissionMode}</Text>
            </Text>
            <Text color="gray">
              {" "}
              Output style: <Text color="white">{outputStyle}</Text>
            </Text>
            <Text color="gray">
              {" "}
              Sandbox: <Text color="white">{sandbox}</Text>
            </Text>
            {role && (
              <Text color="gray">
                {" "}
                Active role: <Text color="magenta">{role}</Text>
              </Text>
            )}
            <Text> </Text>
            <Text>
              {" "}
              <Text color="yellow" bold>
                ●
              </Text>{" "}
              <Text bold>Budget</Text>
            </Text>
            <Text color="gray"> Edit in ~/.brainstorm/config.toml</Text>
            <Text> </Text>
            <Text>
              {" "}
              <Text color="blue" bold>
                ●
              </Text>{" "}
              <Text bold>Providers</Text>
            </Text>
            <Text color="gray"> Edit in ~/.brainstorm/config.toml</Text>
            <Text> </Text>
            <Text>
              {" "}
              <Text color="cyan" bold>
                ●
              </Text>{" "}
              <Text bold>MCP Servers</Text>
            </Text>
            <Text color="gray"> Edit in ~/.brainstorm/config.toml</Text>
          </Box>
        </Box>

        {/* Right: Agents + Vault */}
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
            Agents & Security
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              {" "}
              <Text bold>Vault</Text>
            </Text>
            <Text color="gray"> Use /vault to manage API keys</Text>
            <Text color="gray"> Keys resolve: vault → 1Password → env</Text>
            <Text> </Text>
            <Text>
              {" "}
              <Text bold>Agents</Text>
            </Text>
            <Text color="gray"> Use `storm agent list` to view</Text>
            <Text color="gray"> Use `storm agent create` to add</Text>
            <Text> </Text>
            <Text>
              {" "}
              <Text bold>Workflows</Text>
            </Text>
            <Text color="gray"> Use `storm workflow list` to view</Text>
            <Text color="gray"> Presets: implement-feature, fix-bug,</Text>
            <Text color="gray"> code-review, explain</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
