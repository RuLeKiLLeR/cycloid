interface ToggleProps {
  checked: boolean;
  onChange: () => void;
  label: string;
  className?: string;
  disabled?: boolean;
  showLabel?: boolean;
}

export function Toggle({ checked, onChange, label, className, disabled = false, showLabel = true }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`flex items-center gap-3 text-left control-lg transition-opacity duration-150 ${
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      }${className ? ` ${className}` : ""}`}
    >
      <span
        aria-hidden="true"
        className={`relative inline-flex h-[18px] w-8 items-center rounded-full p-[2px] transition-colors duration-200 shrink-0 border ${
          checked ? "bg-accent border-accent" : "bg-surface-2 border-border"
        }`}
      >
        <span
          className={`inline-block h-[12px] w-[12px] rounded-full transition-transform duration-200 ${
            checked ? "translate-x-[14px] bg-surface-0" : "translate-x-0 bg-text-secondary"
          }`}
        />
      </span>
      {showLabel && <span className="text-sm text-text-primary">{label}</span>}
    </button>
  );
}
