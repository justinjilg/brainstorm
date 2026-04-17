import { RollingCost } from "./RollingCost";

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "var(--color-anthropic)",
  openai: "var(--color-openai)",
  google: "var(--color-google)",
  deepseek: "var(--color-deepseek)",
  local: "var(--color-local)",
};

const KAIROS_COLORS: Record<string, string> = {
  running: "var(--ctp-green)",
  sleeping: "var(--ctp-blue)",
  paused: "var(--ctp-yellow)",
  stopped: "var(--ctp-overlay0)",
};

function costColor(cost: number): string {
  if (cost >= 5) return "var(--sig-err)";
  if (cost >= 0.5) return "var(--sig-warn)";
  return "var(--sig-ok)";
}

function contextColor(percent: number): string {
  if (percent >= 85) return "var(--sig-err)";
  if (percent >= 60) return "var(--sig-warn)";
  return "var(--sig-ok)";
}

interface StatusRailProps {
  role: string | null;
  model: string;
  provider: string;
  strategy: string;
  cost: number;
  contextPercent: number;
  kairosStatus: "running" | "sleeping" | "paused" | "stopped";
  permissionMode: "auto" | "confirm" | "plan";
  onRoleClick: () => void;
  onModelClick: () => void;
  onStrategyClick: () => void;
  onPermissionClick: () => void;
}

export function StatusRail({
  role,
  model,
  provider,
  strategy,
  cost,
  contextPercent,
  kairosStatus,
  permissionMode,
  onRoleClick,
  onModelClick,
  onStrategyClick: _onStrategyClick,
  onPermissionClick: _onPermissionClick,
}: StatusRailProps) {
  const providerColor = PROVIDER_COLORS[provider] ?? "var(--ctp-text)";

  return (
    <div
      className="flex items-center justify-between shrink-0 select-none tabular-nums font-mono"
      style={{
        height: 32,
        padding: "0 12px",
        background: "var(--ink-0)",
        borderTop: "1px solid var(--ink-line)",
        fontSize: "var(--text-2xs)",
        letterSpacing: "0.04em",
      }}
    >
      {/* Left: identity */}
      <div className="flex items-center gap-1">
        {role && (
          <button
            onClick={onRoleClick}
            data-testid="status-role"
            data-tooltip="Change role"
            className="interactive flex items-center gap-1 px-2 py-1 rounded-md"
          >
            <span
              style={{
                color: "var(--bone)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              {role}
            </span>
          </button>
        )}

        <Divider />

        <button
          onClick={onModelClick}
          data-testid="status-model"
          data-tooltip={`Model: ${model} (${provider})`}
          className="interactive flex items-center gap-1.5 px-2 py-1 rounded-md"
        >
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: providerColor }}
          />
          <span style={{ color: "var(--bone)" }}>{model}</span>
        </button>

        <Divider />

        <span
          data-testid="status-strategy"
          data-tooltip={`Routing strategy: ${strategy}`}
          className="px-2 py-1 rounded-md"
          style={{
            color: "var(--bone-mute)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          {strategy}
        </span>
      </div>

      {/* Right: metering */}
      <div className="flex items-center gap-1">
        {/* Cost — per-digit flash on change so the user notices ticks */}
        <RollingCost cost={cost} color={costColor(cost)} testId="status-cost" />

        <Divider />

        {/* Context gauge */}
        <div
          className="flex items-center gap-1.5 px-2"
          data-tooltip={`Context window: ${contextPercent}% used`}
        >
          <span
            style={{
              color: "var(--bone-mute)",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
            }}
          >
            ctx
          </span>
          <div
            className="rounded-full overflow-hidden"
            style={{
              width: 80,
              height: 3,
              background: "var(--ink-3)",
            }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, contextPercent)}%`,
                backgroundColor: contextColor(contextPercent),
                transition:
                  "width var(--duration-normal) var(--ease-out), background-color var(--duration-normal) var(--ease-out)",
              }}
            />
          </div>
          <span
            className="w-8 text-right tabular-nums"
            style={{ color: "var(--bone-mute)" }}
          >
            {contextPercent}%
          </span>
        </div>

        <Divider />

        {/* KAIROS */}
        <div
          className="flex items-center gap-1.5 px-2"
          data-tooltip={`KAIROS: ${kairosStatus}`}
        >
          <span
            className={`w-2 h-2 rounded-full ${kairosStatus === "running" ? "animate-pulse-glow" : ""}`}
            style={{ backgroundColor: KAIROS_COLORS[kairosStatus] }}
          />
          <span
            style={{
              color: "var(--bone-mute)",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
            }}
          >
            KAIROS
          </span>
        </div>

        <Divider />

        {/* Permission mode */}
        <span
          data-testid="status-permission"
          data-tooltip={`Permission mode: ${permissionMode}`}
          className="px-2 py-1 rounded-md"
          style={{
            color:
              permissionMode === "auto"
                ? "var(--sig-ok)"
                : permissionMode === "confirm"
                  ? "var(--sig-warn)"
                  : "var(--sig-info)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          {permissionMode}
        </span>
      </div>
    </div>
  );
}

function Divider() {
  return (
    <div
      style={{
        width: 1,
        height: 12,
        background: "var(--ink-line-strong)",
        margin: "0 2px",
      }}
    />
  );
}
