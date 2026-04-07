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

const PERMISSION_COLORS: Record<string, string> = {
  auto: "var(--ctp-green)",
  confirm: "var(--ctp-yellow)",
  plan: "var(--ctp-sky)",
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
    <div className="h-7 px-3 flex items-center justify-between bg-[var(--ctp-mantle)] border-t border-[var(--ctp-surface0)] text-[11px] shrink-0 select-none">
      {/* Left: identity + context */}
      <div className="flex items-center gap-3">
        {role && (
          <button
            onClick={onRoleClick}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[var(--ctp-surface0)] transition-colors"
          >
            <span className="text-[var(--ctp-mauve)]">{role}</span>
          </button>
        )}

        <button
          onClick={onModelClick}
          className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-[var(--ctp-surface0)] transition-colors"
        >
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: providerColor }}
          />
          <span style={{ color: providerColor }}>{model}</span>
        </button>

        <button
          onClick={onStrategyClick}
          className="px-1.5 py-0.5 rounded text-[var(--ctp-overlay1)] hover:bg-[var(--ctp-surface0)] hover:text-[var(--ctp-text)] transition-colors"
        >
          {strategy}
        </button>
      </div>

      {/* Right: metering */}
      <div className="flex items-center gap-3">
        {/* Cost */}
        <span style={{ color: costColor(cost) }}>${cost.toFixed(4)}</span>

        {/* Context gauge */}
        <div className="flex items-center gap-1.5">
          <span className="text-[var(--ctp-overlay0)]">ctx</span>
          <div className="w-16 h-1.5 rounded-full bg-[var(--ctp-surface0)] overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${Math.min(100, contextPercent)}%`,
                backgroundColor: contextColor(contextPercent),
              }}
            />
          </div>
          <span className="text-[var(--ctp-overlay0)] w-7 text-right">
            {contextPercent}%
          </span>
        </div>

        {/* KAIROS */}
        <div className="flex items-center gap-1">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: KAIROS_COLORS[kairosStatus] }}
          />
          <span className="text-[var(--ctp-overlay0)]">KAIROS</span>
        </div>

        {/* Permission mode */}
        <button
          onClick={onPermissionClick}
          className="px-1.5 py-0.5 rounded hover:bg-[var(--ctp-surface0)] transition-colors"
          style={{ color: PERMISSION_COLORS[permissionMode] }}
        >
          {permissionMode}
        </button>
      </div>
    </div>
  );
}
