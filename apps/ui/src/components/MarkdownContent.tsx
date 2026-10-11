import { isValidElement, memo, type ReactNode, useMemo, useRef, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useMountEffect } from "../hooks/useEffects";

function isClickableMarkdownHref(href: string | undefined): href is string {
  if (!href) return false;
  try {
    // This transcript renderer only emits anchors that resolve outside the app.
    // Repo-relative, sandbox-local, and fragment-only targets are plain text.
    const parsed = new URL(href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

function isImageMarkdownHref(href: string | undefined): href is string {
  if (!isClickableMarkdownHref(href)) return false;
  try {
    const pathname = new URL(href).pathname.toLowerCase();
    return /\.(?:avif|gif|jpe?g|png|webp)$/.test(pathname);
  } catch {
    return false;
  }
}

function plainText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(plainText).join("");
  if (isValidElement<{ children?: ReactNode }>(children)) return plainText(children.props.children);
  return "";
}

function imagePreviewContent(src: string, label: string | undefined) {
  return (
    <>
      <img
        src={src}
        alt={label ?? "image"}
        width={4}
        height={3}
        loading="lazy"
        className="block w-full max-h-72 object-contain"
      />
      {label && (
        <span className="block truncate px-2 py-1 text-xs text-accent underline underline-offset-2">{label}</span>
      )}
    </>
  );
}

const MARKDOWN_IMAGE_PREVIEW_WRAPPER_CLASS =
  "my-2 block w-full max-w-full overflow-hidden rounded-md border border-border bg-surface-1 no-underline";

// How long the code-block button shows "Copied" before reverting.
const COPY_FEEDBACK_RESET_MS = 1500;

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useMountEffect(() => () => clearTimeout(resetTimerRef.current ?? undefined));
  return (
    <span className="group/code relative block">
      <code className="block overflow-x-auto rounded-md bg-surface-2 px-3 py-2 text-xs font-mono whitespace-pre">
        {children}
      </code>
      <button
        type="button"
        aria-label="Copy code"
        onClick={() => {
          const text = plainText(children);
          navigator.clipboard
            ?.writeText(text)
            .then(() => {
              setCopied(true);
              resetTimerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_RESET_MS);
            })
            // Clipboard can reject (denied permission, non-secure context); leave
            // the label unchanged rather than falsely showing "Copied".
            .catch(() => setCopied(false));
        }}
        className="absolute right-1.5 top-1.5 rounded border border-border bg-surface-1 px-1.5 py-0.5 text-2xs text-text-muted opacity-0 transition-opacity hover:text-text-primary group-hover/code:opacity-100 focus-visible:opacity-100"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

const blockComponents: Components = {
  h1: ({ children }) => <h1 className="text-xl font-semibold mt-4 mb-2 text-text-primary">{children}</h1>,
  h2: ({ children }) => <h2 className="text-lg font-semibold mt-3 mb-2 text-text-primary">{children}</h2>,
  h3: ({ children }) => <h3 className="text-base font-semibold mt-3 mb-1 text-text-primary">{children}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-semibold mt-2 mb-1 text-text-primary">{children}</h4>,
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 last:mb-0 pl-5 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 last:mb-0 pl-5 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  a: ({ href, children }) => {
    if (isImageMarkdownHref(href)) {
      const label = plainText(children) || href.split("/").pop() || "image";
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={MARKDOWN_IMAGE_PREVIEW_WRAPPER_CLASS}>
          {imagePreviewContent(href, label)}
        </a>
      );
    }
    return isClickableMarkdownHref(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  img: ({ src, alt }) => {
    if (!isClickableMarkdownHref(src)) return null;
    if (!isImageMarkdownHref(src)) {
      return <div className={MARKDOWN_IMAGE_PREVIEW_WRAPPER_CLASS}>{imagePreviewContent(src, alt ?? undefined)}</div>;
    }
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className={MARKDOWN_IMAGE_PREVIEW_WRAPPER_CLASS}>
        {imagePreviewContent(src, alt ?? undefined)}
      </a>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3 italic text-text-muted mb-2 last:mb-0">{children}</blockquote>
  ),
  code: ({ className, children }) => {
    const isBlock = className?.startsWith("language-");
    if (isBlock) return <CodeBlock>{children}</CodeBlock>;
    return <code className="bg-surface-2 rounded px-1 py-0.5 text-xs font-mono">{children}</code>;
  },
  pre: ({ children }) => <pre className="mb-2 last:mb-0">{children}</pre>,
  table: ({ children }) => (
    <div className="overflow-x-auto mb-2 last:mb-0">
      <table className="text-xs border-collapse border border-border">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface-2">{children}</thead>,
  th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
  hr: () => <hr className="border-border my-3" />,
  strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
};

function componentsWithPrefix(prefix: ReactNode | undefined): Components {
  if (!prefix) return blockComponents;

  let renderedPrefix = false;
  return {
    ...blockComponents,
    p: ({ children }) => {
      const shouldRenderPrefix = !renderedPrefix;
      renderedPrefix = true;
      return (
        <p className="mb-2 last:mb-0">
          {shouldRenderPrefix && prefix}
          {children}
        </p>
      );
    },
  };
}

const inlineComponents: Components = {
  p: ({ children }) => <>{children}</>,
  a: ({ href, children }) =>
    isClickableMarkdownHref(href) && !isImageMarkdownHref(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: () => null,
  code: ({ children }) => (
    <code className="bg-surface-2 rounded px-1 py-0.5 text-xs font-mono whitespace-pre-wrap">{children}</code>
  ),
  pre: ({ children }) => <>{children}</>,
  strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
};

function shouldRenderPrefixOutsideMarkdown(content: string): boolean {
  return /^\s*(?:#{1,6}\s|[-+*]\s|\d+\.\s|```|~~~|>|\|)/.test(content);
}

const LONG_PARAGRAPH_THRESHOLD = 280;

// Insert paragraph breaks into long unbroken prose blocks. The model sometimes
// emits multi-sentence answers as a single line; without breaks they render as
// a wall. We only split blocks that have no existing internal structure (no
// newlines, no code fences) and only at sentence boundaries followed by an
// uppercase letter or inline-code start, to avoid breaking decimals like 1.5
// or path-like tokens like apps/ui/src/Layout.tsx.
function loosenLongParagraphs(content: string): string {
  return content
    .split(/\n\n+/)
    .map((block) => {
      if (block.includes("\n")) return block;
      if (shouldRenderPrefixOutsideMarkdown(block)) return block;
      if (block.length < LONG_PARAGRAPH_THRESHOLD) return block;
      const split = block.split(/(?<=[.!?]) (?=[A-Z`])/g);
      return split.length > 1 ? split.join("\n\n") : block;
    })
    .join("\n\n");
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  prefix,
  variant = "block",
}: {
  content: string;
  prefix?: ReactNode;
  variant?: "block" | "inline";
}) {
  const loosened = useMemo(() => (variant === "inline" ? content : loosenLongParagraphs(content)), [content, variant]);
  if (variant === "inline") {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={inlineComponents}
        allowedElements={["p", "a", "code", "strong", "em", "del", "br"]}
        unwrapDisallowed
      >
        {loosened}
      </ReactMarkdown>
    );
  }

  const renderPrefixOutside = Boolean(prefix && shouldRenderPrefixOutsideMarkdown(loosened));
  // Wrapper class scopes a reset in App.css so global display-serif h1–h6
  // rules don't leak into AI-generated markdown headings.
  return (
    <div className="markdown-content">
      {renderPrefixOutside && <p className="mb-2 last:mb-0">{prefix}</p>}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={componentsWithPrefix(renderPrefixOutside ? undefined : prefix)}
      >
        {loosened}
      </ReactMarkdown>
    </div>
  );
});

export function InlineMarkdownContent({ content }: { content: string }) {
  return <MarkdownContent content={content} variant="inline" />;
}
