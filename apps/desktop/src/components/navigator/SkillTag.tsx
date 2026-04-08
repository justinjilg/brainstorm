/**
 * SkillTag — draggable skill badge.
 * Can be dragged onto agent cards to add skills.
 */

interface SkillTagProps {
  name: string;
  active?: boolean;
  draggable?: boolean;
  onRemove?: () => void;
}

export function SkillTag({
  name,
  active,
  draggable = true,
  onRemove,
}: SkillTagProps) {
  const shortName = name.split("-").slice(0, 2).join("-");

  return (
    <span
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("skill", name);
        e.dataTransfer.effectAllowed = "copy";
      }}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
      style={{
        fontSize: "var(--text-2xs)",
        color: active ? "var(--ctp-green)" : "var(--ctp-overlay1)",
        background: active ? "var(--glow-green)" : "var(--ctp-crust)",
        border: `1px solid ${active ? "rgba(166, 227, 161, 0.2)" : "var(--border-subtle)"}`,
        transition: "all var(--duration-fast) var(--ease-out)",
      }}
      title={name}
    >
      {shortName}
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="opacity-50 hover:opacity-100"
          style={{ fontSize: "var(--text-2xs)" }}
        >
          ×
        </button>
      )}
    </span>
  );
}
