/**
 * Security View — red team scorecard, defense layers, trust state.
 */

export function SecurityView() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--ctp-surface0)]">
        <span className="text-xs font-medium text-[var(--ctp-overlay0)] uppercase tracking-wider">
          Security Dashboard
        </span>
        <button className="text-[10px] px-3 py-1 rounded-lg bg-[var(--ctp-mauve)] text-[var(--ctp-crust)] hover:brightness-110">
          Run Red Team
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Defense Scorecard */}
        <div>
          <SectionHeader title="Defense Scorecard" />
          <div className="mt-2 p-4 rounded-lg bg-[var(--ctp-surface0)] font-mono text-xs leading-relaxed">
            <div className="text-[var(--ctp-overlay0)] mb-2">
              Run the red team engine to generate an adversarial defense
              scorecard. The engine breeds attack populations, tests them
              against the 8-layer middleware pipeline, and reports evasion rates
              per category.
            </div>
            <div className="space-y-1">
              <ScoreRow
                label="Privilege Escalation"
                status="SECURE"
                bar={100}
              />
              <ScoreRow label="Policy Poisoning" status="SECURE" bar={100} />
              <ScoreRow
                label="Semantic Manipulation"
                status="SECURE"
                bar={100}
              />
              <ScoreRow label="Approval Fatigue" status="SECURE" bar={100} />
              <ScoreRow
                label="Content Injection"
                status="95% evade"
                bar={5}
                warn
              />
              <ScoreRow label="Exfiltration" status="79% evade" bar={21} warn />
            </div>
          </div>
        </div>

        {/* Middleware Pipeline */}
        <div>
          <SectionHeader title="Middleware Pipeline (8 security layers)" />
          <div className="mt-2 space-y-1">
            {[
              {
                name: "trust-propagation",
                desc: "Taint tracking through pipeline",
                position: 1,
              },
              {
                name: "content-injection-filter",
                desc: "Sanitize web content at ingestion",
                position: 2,
              },
              {
                name: "tool-contract-enforcement",
                desc: "Validate tool arguments",
                position: 3,
              },
              {
                name: "tool-sequence-detector",
                desc: "Trust-aware pattern matching",
                position: 4,
              },
              {
                name: "egress-monitor",
                desc: "Block exfiltration patterns",
                position: 5,
              },
              {
                name: "approval-friction",
                desc: "Approval velocity + cooling",
                position: 6,
              },
              {
                name: "security-scan",
                desc: "Credential detection in writes",
                position: 7,
              },
              {
                name: "policy-validator",
                desc: "Local file injection detection",
                position: 8,
              },
            ].map((layer) => (
              <div
                key={layer.name}
                className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--ctp-surface0)]"
              >
                <span className="w-5 h-5 rounded-full bg-[var(--ctp-green)]/20 text-[var(--ctp-green)] text-[10px] flex items-center justify-center font-medium">
                  {layer.position}
                </span>
                <div className="flex-1">
                  <div className="text-xs text-[var(--ctp-text)] font-mono">
                    {layer.name}
                  </div>
                  <div className="text-[10px] text-[var(--ctp-overlay0)]">
                    {layer.desc}
                  </div>
                </div>
                <span className="w-2 h-2 rounded-full bg-[var(--ctp-green)]" />
              </div>
            ))}
          </div>
        </div>

        {/* Trust Window */}
        <div>
          <SectionHeader title="Current Trust Window" />
          <div className="mt-2 p-3 rounded-lg bg-[var(--ctp-surface0)]">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-[var(--ctp-overlay0)]">Min trust:</span>
              <span className="text-[var(--ctp-green)]">1.0</span>
              <span className="text-[var(--ctp-overlay0)]">·</span>
              <span className="text-[var(--ctp-overlay0)]">Tainted:</span>
              <span className="text-[var(--ctp-green)]">No</span>
            </div>
            <div className="mt-2 text-[10px] text-[var(--ctp-overlay0)]">
              Trust window is clean. No untrusted content in recent tool
              results.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="text-xs font-medium text-[var(--ctp-overlay0)] uppercase tracking-wider">
      {title}
    </div>
  );
}

function ScoreRow({
  label,
  status,
  bar,
  warn,
}: {
  label: string;
  status: string;
  bar: number;
  warn?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[var(--ctp-subtext0)] w-44">{label}</span>
      <div className="w-24 h-1.5 rounded-full bg-[var(--ctp-crust)] overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{
            width: `${bar}%`,
            backgroundColor: warn ? "var(--ctp-red)" : "var(--ctp-green)",
          }}
        />
      </div>
      <span
        className="w-20 text-right"
        style={{ color: warn ? "var(--ctp-red)" : "var(--ctp-green)" }}
      >
        {status}
      </span>
    </div>
  );
}
