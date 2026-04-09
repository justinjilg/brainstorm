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
  if (cost >= 5) return "var(--ctp-red)";
  if (cost >= 0.5) return "var(--ctp-yellow)";
  return "var(--ctp-green)";
}

function contextColor(percent: number): string {
  if (percent >= 85) return "var(--ctp-red)";
  if (percent >= 60) return "var(--ctp-yellow)";
  return "var(--ctp-green)";
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
  onStrategyClick,
  onPermissionClick,
}: StatusRailProps) {
  const providerColor = PROVIDER_COLORS[provider] ?? "var(--ctp-text)";

  return (
    <div
      className="flex items-center justify-between shrink-0 select-none"
      style={{
        height: 32,
        padding: "0 12px",
        background: "var(--ctp-mantle)",
        borderTop: "1px solid var(--border-subtle)",
        fontSize: "var(--text-2xs)",
      }}
    >
      {/* Left: identity */}
      <div className="flex items-center gap-1">
        {role && (
          <button
            onClick={onRoleClick}
            data-testid="status-role"
            className="interactive flex items-center gap-1 px-2 py-1 rounded-md"
            title="Change role"
          >
            <span style={{ color: "var(--ctp-mauve)" }}>{role}</span>
          </button>
        )}

        <Divider />

        <button
          onClick={onModelClick}
          data-testid="status-model"
          className="interactive flex items-center gap-1.5 px-2 py-1 rounded-md"
          title={`Model: ${model} (${provider})`}
        >
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: providerColor }}
          />
          <span style={{ color: providerColor }}>{model}</span>
        </button>

        <Divider />

        <button
          onClick={onStrategyClick}
          data-testid="status-strategy"
          className="interactive px-2 py-1 rounded-md text-[var(--ctp-overlay1)]"
          title={`Routing strategy: ${strategy}`}
        >
          {strategy}
        </button>
      </div>

      {/* Right: metering */}
      <div className="flex items-center gap-1">
        {/* Cost */}
        <span
          className="font-mono px-2"
          data-testid="status-cost"
          style={{ color: costColor(cost) }}
          title={`Session cost: $${cost.toFixed(4)}`}
        >
          ${cost.toFixed(4)}
        </span>

        <Divider />

        {/* Context gauge */}
        <div
          className="flex items-center gap-1.5 px-2"
          title={`Context window: ${contextPercent}% used`}
        >
          <span className="text-[var(--ctp-overlay0)]">ctx</span>
          <div
            className="rounded-full overflow-hidden"
            style={{
              width: 80,
              height: 3,
              background: "var(--ctp-surface0)",
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
          <span className="text-[var(--ctp-overlay0)] w-7 text-right font-mono">
            {contextPercent}%
          </span>
        </div>

        <Divider />

        {/* KAIROS */}
        <div
          className="flex items-center gap-1.5 px-2"
          title={`KAIROS: ${kairosStatus}`}
        >
          <span
            className={`w-2 h-2 rounded-full ${kairosStatus === "running" ? "animate-pulse-glow" : ""}`}
            style={{ backgroundColor: KAIROS_COLORS[kairosStatus] }}
          />
          <span className="text-[var(--ctp-overlay0)]">KAIROS</span>
        </div>

        <Divider />

        {/* Permission mode */}
        <button
          onClick={onPermissionClick}
          data-testid="status-permission"
          className="interactive px-2 py-1 rounded-md"
          style={{
            color:
              permissionMode === "auto"
                ? "var(--ctp-green)"
                : permissionMode === "confirm"
                  ? "var(--ctp-yellow)"
                  : "var(--ctp-sky)",
          }}
          title={`Permission mode: ${permissionMode} (click to cycle)`}
        >
          {permissionMode}
        </button>
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
        background: "var(--border-subtle)",
        margin: "0 2px",
      }}
    />
  );
}
