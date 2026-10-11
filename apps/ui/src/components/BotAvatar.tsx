import { LogoMark } from "./icons/LogoMark";

export function BotAvatar() {
  return (
    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface-1 shadow-sm">
      <LogoMark title="Cycloid" className="h-[18px] w-[18px]" />
    </div>
  );
}
