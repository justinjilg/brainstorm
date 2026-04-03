/**
 * Dashboard Mode — Full Ecosystem Inventory
 *
 * Three panels showing everything registered in the Brainstorm platform:
 * Left:   Connected systems with health + routing history
 * Center: Tool registry grouped by domain + tool health
 * Right:  Audit trail + cost trends
 *
 * Data sources:
 * - godModeInfo: from ProductConnector discovery at boot
 * - toolStats: captured from agent loop events
 * - brData: fetched from BrainstormRouter API
 * - routingHistory: captured from routing decisions
 */

import React, { useEffect } from "react";
import { Box, Text } from "ink";
import { Gauge } from "../viz/Gauge.js";
import { Sparkline } from "../viz/Sparkline.js";
import { getProviderColor } from "../../theme.js";
import type { BRDashboardData } from "../../hooks/useBRData.js";

interface RoutingEntry {
  model: string;
  strategy: string;
  reason: string;
  timestamp: number;
}

interface ToolStat {
  name: string;
  calls: number;
  successes: number;
}

interface ConnectedSystem {
  name: string;
  displayName: string;
  capabilities: string[];
  latencyMs: number;
  toolCount: number;
}

interface DashboardModeProps {
  sessionCost: number;
  tokenCount: { input: number; output: number };
  modelCount: { local: number; cloud: number };
  routingHistory: RoutingEntry[];
  toolStats: ToolStat[];
  turnCount: number;
  sessionStart: number;
  brData?: BRDashboardData;
  onRefreshBR?: () => void;
  godModeInfo?: {
    connectedSystems: ConnectedSystem[];
    errors: Array<{ name: string; error: string }>;
    totalTools: number;
  };
}

function formatElapsed(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
}

/** Group tools by their product prefix (msp_, br_, gtm_, etc.). */
function groupToolsByDomain(
  systems: ConnectedSystem[],
): Array<{ domain: string; product: string; count: number }> {
  const groups: Array<{ domain: string; product: string; count: number }> = [];
  for (const sys of systems) {
    for (const cap of sys.capabilities) {
      groups.push({
        domain: cap,
        product: sys.name,
        count: Math.ceil(sys.toolCount / Math.max(sys.capabilities.length, 1)),
      });
    }
  }
  return groups;
}

export function DashboardMode({
  sessionCost,
  tokenCount,
  modelCount,
  routingHistory,
  toolStats,
  turnCount,
  sessionStart,
  brData,
  onRefreshBR,
  godModeInfo,
}: DashboardModeProps) {
  const elapsed = Date.now() - sessionStart;
  const costPerHour = elapsed > 60000 ? (sessionCost / elapsed) * 3600000 : 0;
  const gm = godModeInfo;
  const domainGroups = gm ? groupToolsByDomain(gm.connectedSystems) : [];

  useEffect(() => {
    if (onRefreshBR && (!brData || brData.lastFetched === 0)) {
      onRefreshBR();
    }
  }, []);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Row 1: Session Stats + Platform Stats */}
      <Box
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        flexDirection="row"
        justifyContent="space-between"
      >
        <Box flexDirection="column">
          <Text color="gray">Session</Text>
          <Text color="yellow" bold>
            ${sessionCost.toFixed(4)}
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text color="gray">Tokens</Text>
          <Text>
            {formatTokens(tokenCount.input)}
            <Text color="gray">↑</Text> {formatTokens(tokenCount.output)}
            <Text color="gray">↓</Text>
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text color="gray">Turns</Text>
          <Text bold>{turnCount}</Text>
        </Box>
        <Box flexDirection="column">
          <Text color="gray">Elapsed</Text>
          <Text>{formatElapsed(elapsed)}</Text>
        </Box>
        <Box flexDirection="column">
          <Text color="gray">$/hour</Text>
          <Text
            color={
              costPerHour > 5 ? "red" : costPerHour > 1 ? "yellow" : "green"
            }
          >
            ${costPerHour.toFixed(2)}
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text color="gray">Products</Text>
          <Text
            color={gm && gm.connectedSystems.length > 0 ? "green" : "gray"}
            bold
          >
            {gm?.connectedSystems.length ?? 0}
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text color="gray">Tools</Text>
          <Text bold>{gm?.totalTools ?? 0}</Text>
        </Box>
        <Box flexDirection="column">
          <Text color="gray">Models</Text>
          <Text>
            {modelCount.local}L/{modelCount.cloud}C
          </Text>
        </Box>
      </Box>

      {/* Row 2: Three panels */}
      <Box marginTop={1} flexDirection="row" flexGrow={1}>
        {/* LEFT: Connected Systems + Routing */}
        <Box
          borderStyle="round"
          borderColor="gray"
          flexGrow={1}
          paddingX={1}
          flexDirection="column"
        >
          <Text bold color="green">
            {" "}
            Connected Systems
          </Text>
          {gm && gm.connectedSystems.length > 0 ? (
            gm.connectedSystems.map((sys) => (
              <Box key={sys.name}>
                <Text color="green">● </Text>
                <Text bold>{sys.displayName.padEnd(18)}</Text>
                <Text color="gray">{String(sys.toolCount).padStart(2)}t </Text>
                <Text color="gray" dimColor>
                  {sys.latencyMs}ms
                </Text>
              </Box>
            ))
          ) : (
            <Text color="gray" dimColor>
              {" "}
              No products connected
            </Text>
          )}
          {gm &&
            gm.errors.length > 0 &&
            gm.errors.map((err) => (
              <Box key={err.name}>
                <Text color="red">○ </Text>
                <Text color="gray">{err.name.padEnd(18)}</Text>
                <Text color="red" dimColor>
                  {err.error.slice(0, 25)}
                </Text>
              </Box>
            ))}

          <Text> </Text>
          <Text bold color="blue">
            {" "}
            Routing Log
          </Text>
          {routingHistory.length === 0 ? (
            <Text color="gray" dimColor>
              {" "}
              Send a message to start.
            </Text>
          ) : (
            routingHistory.slice(0, 5).map((entry, i) => (
              <Box key={i}>
                <Text color="gray" dimColor>
                  {timeAgo(entry.timestamp).padEnd(8)}
                </Text>
                <Text color={getProviderColor(entry.model)} bold>
                  {entry.model.padEnd(16)}
                </Text>
                <Text color="gray">{entry.strategy}</Text>
              </Box>
            ))
          )}

          {brData && brData.leaderboard.length > 0 && (
            <>
              <Text> </Text>
              <Text bold color="yellow">
                {" "}
                Leaderboard
              </Text>
              {brData.leaderboard
                .filter((e) => e?.model)
                .slice(0, 4)
                .map((entry, i) => (
                  <Box key={i}>
                    <Text color="gray">{String(i + 1).padStart(2)}. </Text>
                    <Text color={getProviderColor(entry.provider ?? "")} bold>
                      {(entry.model ?? "unknown")
                        .split("/")
                        .pop()
                        ?.padEnd(16) ?? "unknown".padEnd(16)}
                    </Text>
                    <Text color="gray">
                      Q{entry.quality_rank ?? "?"} S{entry.speed_rank ?? "?"}
                    </Text>
                  </Box>
                ))}
            </>
          )}
        </Box>

        {/* CENTER: Tool Registry by Domain + Health */}
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
            Tool Registry ({gm?.totalTools ?? 0})
          </Text>
          {domainGroups.length > 0 ? (
            domainGroups.slice(0, 8).map((g) => (
              <Box key={`${g.product}-${g.domain}`}>
                <Text color="gray">{g.product.padEnd(6)}</Text>
                <Text>{g.domain.padEnd(20)}</Text>
                <Text color="gray" dimColor>
                  {g.count}t
                </Text>
              </Box>
            ))
          ) : (
            <Text color="gray" dimColor>
              {" "}
              No tools registered
            </Text>
          )}

          {toolStats.length > 0 && (
            <>
              <Text> </Text>
              <Text bold color="magenta">
                {" "}
                Tool Health
              </Text>
              {toolStats
                .sort((a, b) => b.calls - a.calls)
                .slice(0, 6)
                .map((tool) => {
                  const rate =
                    tool.calls > 0
                      ? Math.round((tool.successes / tool.calls) * 100)
                      : 0;
                  const color =
                    rate >= 90 ? "green" : rate >= 70 ? "yellow" : "red";
                  return (
                    <Box key={tool.name}>
                      <Text color={color}>
                        {rate >= 90 ? "●" : rate >= 70 ? "◐" : "○"}{" "}
                      </Text>
                      <Text>{tool.name.padEnd(18)}</Text>
                      <Text color="gray">
                        {String(tool.calls).padStart(3)}{" "}
                      </Text>
                      <Gauge value={rate} width={6} showPercent={false} />
                    </Box>
                  );
                })}
            </>
          )}

          {brData?.waste && brData.waste.total_waste_usd > 0 && (
            <>
              <Text> </Text>
              <Text bold color="red">
                {" "}
                Waste: ${(brData.waste?.total_waste_usd ?? 0).toFixed(2)}
              </Text>
            </>
          )}
        </Box>

        {/* RIGHT: Audit + Cost Trends */}
        <Box
          borderStyle="round"
          borderColor="gray"
          flexGrow={1}
          paddingX={1}
          marginLeft={1}
          flexDirection="column"
        >
          <Text bold color="magenta">
            {" "}
            Audit Trail
          </Text>
          {!brData || brData.audit.length === 0 ? (
            <Text color="gray" dimColor>
              {" "}
              No audit data. Press r to refresh.
            </Text>
          ) : (
            brData.audit
              .filter((e) => e != null)
              .slice(0, 5)
              .map((entry, i) => {
                const statusColor =
                  entry.guardian_status === "safe"
                    ? "green"
                    : entry.guardian_status === "flagged"
                      ? "yellow"
                      : "red";
                return (
                  <Box key={i}>
                    <Text color={statusColor}>
                      {entry.guardian_status === "safe" ? "●" : "⚠"}{" "}
                    </Text>
                    <Text color={getProviderColor(entry.model ?? "")}>
                      {(entry.model ?? "").split("/").pop()?.padEnd(12) ?? ""}
                    </Text>
                    <Text color="gray">
                      ${(entry.cost_usd ?? 0).toFixed(4)}
                    </Text>
                  </Box>
                );
              })
          )}

          {brData && brData.dailyTrend.length > 0 && (
            <>
              <Text> </Text>
              <Text bold color="blue">
                {" "}
                7-Day Cost
              </Text>
              <Box>
                <Sparkline
                  data={brData.dailyTrend.map((d) => d?.cost_usd ?? 0)}
                  color="yellow"
                  width={18}
                />
                <Text color="gray">
                  {" "}
                  $
                  {brData.dailyTrend
                    .reduce((s, d) => s + d.cost_usd, 0)
                    .toFixed(2)}
                </Text>
              </Box>
            </>
          )}

          {brData?.forecast && (
            <>
              <Text> </Text>
              <Text bold color={brData.forecast?.will_exceed ? "red" : "green"}>
                {" "}
                Forecast: ${(brData.forecast?.projected_spend ?? 0).toFixed(2)}
              </Text>
            </>
          )}
        </Box>
      </Box>

      {/* Bottom: Status bar */}
      <Box paddingX={1}>
        <Text color="gray" dimColor>
          {brData?.loading
            ? "Loading..."
            : brData?.error
              ? `BR: ${brData.error}`
              : `r refresh │ Esc chat │ ${gm ? `${gm.connectedSystems.length} products │ ${gm.totalTools} tools` : "godmode off"} │ ${modelCount.local}L/${modelCount.cloud}C`}
        </Text>
      </Box>
    </Box>
  );
}
