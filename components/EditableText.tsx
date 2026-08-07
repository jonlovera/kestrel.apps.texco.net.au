"use client";

/**
 * A piece of the dashboard's wording that becomes typeable in edit mode and is
 * plain text otherwise. Commits on blur or Enter; Escape abandons the edit.
 *
 * Sized and coloured by the caller so it sits invisibly inside whatever it is
 * replacing — the header eyebrow, the banner, a card title, the footer.
 */
export default function EditableText({
  value,
  editing,
  onCommit,
  className = "",
  inputClassName = "",
  maxLength = 80,
  label,
  disabled = false,
}: {
  value: string;
  editing: boolean;
  onCommit: (next: string) => void;
  className?: string;
  inputClassName?: string;
  maxLength?: number;
  label: string;
  disabled?: boolean;
}) {
  if (!editing) return <span className={className}>{value}</span>;

  return (
    <input
      key={value}
      type="text"
      defaultValue={value}
      maxLength={maxLength}
      disabled={disabled}
      aria-label={label}
      title={`${label} — edit and press Enter`}
      onFocus={(e) => e.target.select()}
      onBlur={(e) => {
        const next = e.target.value.trim();
        if (next && next !== value) onCommit(next);
        else e.target.value = value;
      }}
      onKeyDown={(e) => {
        const el = e.target as HTMLInputElement;
        if (e.key === "Enter") el.blur();
        if (e.key === "Escape") {
          el.value = value;
          el.blur();
        }
      }}
      className={`border border-dashed border-current/40 bg-transparent px-1 outline-none focus:border-solid focus:border-[#FC4D0F] disabled:opacity-50 ${className} ${inputClassName}`}
    />
  );
}
