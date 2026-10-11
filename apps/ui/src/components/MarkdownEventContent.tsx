import { memo, Suspense } from "react";

import { lazyWithRetry } from "../lazy-with-retry";

const LazyMarkdownContent = lazyWithRetry(() =>
  import("./MarkdownContent").then((m) => ({ default: m.MarkdownContent })),
);
const LazyInlineMarkdownContent = lazyWithRetry(() =>
  import("./MarkdownContent").then((m) => ({ default: m.InlineMarkdownContent })),
);

export const MarkdownEventContent = memo(function MarkdownEventContent({
  content,
  renderAsPlainText,
  variant = "block",
}: {
  content: string;
  renderAsPlainText: boolean;
  variant?: "block" | "inline";
}) {
  const fallback =
    variant === "inline" ? (
      <span className="whitespace-pre-wrap break-words">{content}</span>
    ) : (
      <div className="whitespace-pre-wrap break-words">{content}</div>
    );
  if (renderAsPlainText) return fallback;
  if (variant === "inline") {
    return (
      <Suspense fallback={fallback}>
        <LazyInlineMarkdownContent content={content} />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={fallback}>
      <LazyMarkdownContent content={content} />
    </Suspense>
  );
});
