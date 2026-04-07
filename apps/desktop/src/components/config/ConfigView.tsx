/**
 * Config View — settings, vault, permissions, KAIROS config.
 */

export function ConfigView() {
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6">
      <Section title="Routing Strategy">
        <OptionRow label="Active strategy" value="combined" />
        <OptionRow
          label="Routing mode"
          value="auto (Thompson sampling when data available)"
        />
        <OptionRow label="Cost weight" value="0.25" />
      </Section>

      <Section title="Permissions">
        <OptionRow
          label="Mode"
          value="confirm"
          badge
          badgeColor="var(--ctp-yellow)"
        />
        <OptionRow label="Session TTL" value="30 minutes" />
        <OptionRow label="Allowlist" value="file_read, glob, grep, list_dir" />
        <OptionRow label="Denylist" value="(none)" />
      </Section>

      <Section title="KAIROS Daemon">
        <OptionRow label="Status" value="stopped" />
        <OptionRow label="Tick interval" value="30,000ms" />
        <OptionRow label="Max ticks/session" value="100" />
        <OptionRow label="Approval gate" value="every 25 ticks" />
        <OptionRow label="Reflection interval" value="every 50 ticks" />
      </Section>

      <Section title="Budget">
        <OptionRow label="Session limit" value="$5.00" />
        <OptionRow label="Daily limit" value="$50.00" />
        <OptionRow label="Monthly limit" value="$500.00" />
        <OptionRow
          label="Hard limit"
          value="enabled"
          badge
          badgeColor="var(--ctp-red)"
        />
      </Section>

      <Section title="Vault">
        <OptionRow label="Local keys" value="3 stored" />
        <OptionRow
          label="1Password"
          value="connected (Dev Keys vault)"
          badge
          badgeColor="var(--ctp-green)"
        />
        <OptionRow label="Encryption" value="AES-256-GCM + Argon2id" />
      </Section>

      <Section title="Memory">
        <OptionRow label="System tier" value="2 entries" />
        <OptionRow label="Archive tier" value="1 entry" />
        <OptionRow label="Quarantine" value="1 entry" />
        <OptionRow label="Git tracking" value="enabled" />
        <OptionRow label="Dream cycle" value="every 50 ticks" />
      </Section>

      <Section title="Security">
        <OptionRow
          label="Middleware layers"
          value="8 active"
          badge
          badgeColor="var(--ctp-green)"
        />
        <OptionRow label="Trust propagation" value="enabled" />
        <OptionRow label="Egress monitor" value="enabled" />
        <OptionRow label="Approval velocity" value="3 rapid threshold" />
        <OptionRow label="Red team" value="last run: never" />
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-[var(--ctp-overlay0)] uppercase tracking-wider mb-2">
        {title}
      </div>
      <div className="rounded-lg bg-[var(--ctp-surface0)] divide-y divide-[var(--ctp-crust)]/30">
        {children}
      </div>
    </div>
  );
}

function OptionRow({
  label,
  value,
  badge,
  badgeColor,
}: {
  label: string;
  value: string;
  badge?: boolean;
  badgeColor?: string;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2 text-xs">
      <span className="text-[var(--ctp-overlay1)]">{label}</span>
      {badge ? (
        <span
          className="px-1.5 py-0.5 rounded text-[10px]"
          style={{
            color: badgeColor,
            backgroundColor: `${badgeColor}20`,
          }}
        >
          {value}
        </span>
      ) : (
        <span className="text-[var(--ctp-text)]">{value}</span>
      )}
    </div>
  );
}
