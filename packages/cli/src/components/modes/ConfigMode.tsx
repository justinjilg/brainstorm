import React from "react";
import { Box, Text } from "ink";
import { getRoleColor } from "../../theme.js";

interface VaultInfo {
  exists: boolean;
  isOpen: boolean;
  keyCount: number;
  keys: string[];
  createdAt: string | null;
  opAvailable: boolean;
  resolvedKeys: string[];
}

interface ConfigModeProps {
  strategy: string;
  permissionMode: string;
  outputStyle: string;
  sandbox: string;
  role?: string;
  modelCount?: { local: number; cloud: number };
  turnCount?: number;
  sessionCost?: number;
  vaultInfo?: VaultInfo;
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

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const days = Math.floor(ms / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

/** Known human-readable labels for provider keys */
const KEY_LABELS: Record<
  string,
  { label: string; provider: string; color: string }
> = {
  BRAINSTORM_API_KEY: {
    label: "BrainstormRouter",
    provider: "brainstorm",
    color: "green",
  },
  ANTHROPIC_API_KEY: {
    label: "Anthropic",
    provider: "anthropic",
    color: "magenta",
  },
  OPENAI_API_KEY: { label: "OpenAI", provider: "openai", color: "yellow" },
  GOOGLE_GENERATIVE_AI_API_KEY: {
    label: "Google AI",
    provider: "google",
    color: "blue",
  },
  DEEPSEEK_API_KEY: { label: "DeepSeek", provider: "deepseek", color: "cyan" },
  MOONSHOT_API_KEY: {
    label: "Moonshot (Kimi)",
    provider: "moonshot",
    color: "white",
  },
  BRAINSTORM_ADMIN_KEY: {
    label: "BR Admin",
    provider: "brainstorm",
    color: "red",
  },
};

export function ConfigMode({
  strategy,
  permissionMode,
  outputStyle,
  sandbox,
  role,
  modelCount,
  turnCount,
  sessionCost,
  vaultInfo,
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

        {/* Right: Vault & Keys */}
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
            Vault & API Keys
          </Text>

          {vaultInfo ? (
            <Box marginTop={1} flexDirection="column">
              {/* Vault status */}
              <Box>
                <Text color="gray"> Status </Text>
                <Text
                  color={
                    vaultInfo.isOpen
                      ? "green"
                      : vaultInfo.exists
                        ? "yellow"
                        : "red"
                  }
                  bold
                >
                  {vaultInfo.isOpen
                    ? "● unlocked"
                    : vaultInfo.exists
                      ? "● locked"
                      : "○ not initialized"}
                </Text>
              </Box>
              {vaultInfo.createdAt && (
                <Box>
                  <Text color="gray"> Created </Text>
                  <Text>{formatAge(vaultInfo.createdAt)}</Text>
                </Box>
              )}
              <Box>
                <Text color="gray"> 1Password </Text>
                <Text color={vaultInfo.opAvailable ? "green" : "gray"}>
                  {vaultInfo.opAvailable ? "● connected" : "○ not available"}
                </Text>
              </Box>

              {/* Key list */}
              <Box marginTop={1} flexDirection="column">
                <Text>
                  {" "}
                  <Text bold>
                    Resolved Keys ({vaultInfo.resolvedKeys.length})
                  </Text>
                </Text>
                {vaultInfo.resolvedKeys.length === 0 ? (
                  <Text color="gray" dimColor>
                    {" "}
                    No keys resolved. Use /vault add or set env vars.
                  </Text>
                ) : (
                  vaultInfo.resolvedKeys.map((key) => {
                    const info = KEY_LABELS[key];
                    return (
                      <Box key={key}>
                        <Text color={info?.color ?? "gray"}> ● </Text>
                        <Text>{(info?.label ?? key).padEnd(20)}</Text>
                        <Text color="gray" dimColor>
                          {key}
                        </Text>
                      </Box>
                    );
                  })
                )}
              </Box>

              {/* Vault keys (if open and different from resolved) */}
              {vaultInfo.isOpen && vaultInfo.keys.length > 0 && (
                <Box marginTop={1} flexDirection="column">
                  <Text>
                    {" "}
                    <Text bold>Vault Keys ({vaultInfo.keyCount})</Text>
                  </Text>
                  {vaultInfo.keys.map((key) => {
                    const info = KEY_LABELS[key];
                    return (
                      <Box key={key}>
                        <Text color="gray"> ◆ </Text>
                        <Text>{(info?.label ?? key).padEnd(20)}</Text>
                        <Text color="gray" dimColor>
                          {key}
                        </Text>
                      </Box>
                    );
                  })}
                </Box>
              )}
            </Box>
          ) : (
            <Box marginTop={1} flexDirection="column">
              <Text color="gray" dimColor>
                {" "}
                Vault info not available.
              </Text>
              <Text color="gray" dimColor>
                {" "}
                Run `brainstorm vault init` to create.
              </Text>
            </Box>
          )}

          {/* Quick commands */}
          <Box marginTop={1} flexDirection="column">
            <Text>
              {" "}
              <Text bold>Commands</Text>
            </Text>
            <Text color="gray"> /vault list Show stored keys</Text>
            <Text color="gray"> /vault add KEY Add a key</Text>
            <Text color="gray"> /role Show available roles</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
