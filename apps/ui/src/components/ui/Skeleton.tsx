import { cx } from "./utils";

export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      className={cx("bg-surface-2 motion-safe:animate-pulse motion-reduce:animate-none", className)}
      aria-hidden="true"
    />
  );
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <SkeletonBlock className="h-8 w-8 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <SkeletonBlock className="h-3 w-2/3" />
            <SkeletonBlock className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
